import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUT_KEY = 'toggle-shortcut';
const DEFAULT_ACCEL = '<Super><Shift>l';

// 충돌을 훑어볼 스키마. 여기 없는 곳(앱 자체 단축키 등)의 충돌은 잡지 못한다.
const CONFLICT_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];

const CUSTOM_LIST_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_ITEM_SCHEMA =
    'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

// 문자열 비교로는 '<Super><Shift>l' 과 '<Shift><Super>L' 을 구분하지 못한다.
// 파싱해서 (keyval, mask) 로 비교한다.
function parseAccel(accel) {
    const [ok, keyval, mask] = Gtk.accelerator_parse(accel);
    return ok ? {keyval, mask} : null;
}

function sameAccel(a, b) {
    return a && b && a.keyval === b.keyval && a.mask === b.mask;
}

// 해당 조합을 이미 쓰고 있는 곳의 이름. 없으면 null.
function findConflict(accel) {
    const target = parseAccel(accel);
    if (!target)
        return null;

    const source = Gio.SettingsSchemaSource.get_default();

    for (const id of CONFLICT_SCHEMAS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const settings = new Gio.Settings({settings_schema: schema});
        for (const key of schema.list_keys()) {
            const value = settings.get_value(key);
            if (value.get_type_string() !== 'as')
                continue;
            for (const accelStr of value.deep_unpack()) {
                if (sameAccel(parseAccel(accelStr), target))
                    return `${id} ${key}`;
            }
        }
    }

    return findCustomConflict(target);
}

// 사용자 정의 단축키는 relocatable 스키마라 경로를 따라가야 한다.
function findCustomConflict(target) {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source.lookup(CUSTOM_ITEM_SCHEMA, true) ||
        !source.lookup(CUSTOM_LIST_SCHEMA, true))
        return null;

    const list = new Gio.Settings({schema_id: CUSTOM_LIST_SCHEMA});
    for (const path of list.get_strv('custom-keybindings')) {
        const item = new Gio.Settings({
            schema_id: CUSTOM_ITEM_SCHEMA,
            path,
        });
        if (sameAccel(parseAccel(item.get_string('binding')), target))
            return item.get_string('name') || '사용자 정의 단축키';
    }
    return null;
}

const ShortcutRow = GObject.registerClass(
class LidAwakeShortcutRow extends Adw.ActionRow {
    _init(settings) {
        super._init({
            title: '깨어 있기 토글',
            subtitle: '눌러서 새 조합을 지정합니다',
            activatable: true,
        });
        this._settings = settings;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: '없음',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        this._reset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: '기본값으로',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._reset.connect('clicked', () => this._set(DEFAULT_ACCEL));
        this.add_suffix(this._reset);
        this.set_activatable_widget(null);

        this.connect('activated', () => this._openCapture());

        this._changedId = settings.connect(
            `changed::${SHORTCUT_KEY}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._changedId));
        this._sync();
    }

    _current() {
        const list = this._settings.get_strv(SHORTCUT_KEY);
        return list.length > 0 ? list[0] : '';
    }

    _set(accel) {
        this._settings.set_strv(SHORTCUT_KEY, accel ? [accel] : []);
    }

    _sync() {
        const accel = this._current();
        this._label.accelerator = accel;

        if (!accel) {
            this.subtitle = '지정되지 않음 — 아이콘으로만 토글';
            return;
        }
        const conflict = findConflict(accel);
        this.subtitle = conflict
            ? `충돌: ${conflict}`
            : '눌러서 새 조합을 지정합니다';
    }

    _openCapture() {
        const dialog = new Adw.AlertDialog({
            heading: '새 단축키 입력',
            body: '원하는 조합을 누르세요.\n' +
                  'Backspace 로 해제, Esc 로 취소합니다.',
        });
        dialog.add_response('cancel', '취소');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() &
                         ~Gdk.ModifierType.LOCK_MASK;

            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                this._set('');
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // 수식키 없는 단일 키는 일반 입력을 잡아먹으므로 받지 않는다.
            if (!isValidBinding(mask, keycode, keyval) ||
                !isValidAccel(mask, keyval))
                return Gdk.EVENT_STOP;

            this._set(Gtk.accelerator_name_with_keycode(
                null, keyval, keycode, mask));
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);

        dialog.present(this.get_root());
    }
});

// gnome-control-center 의 keyboard-shortcuts 검사와 같은 기준.
function isValidBinding(mask, keycode, keyval) {
    if (mask === 0)
        return false;
    if (mask === Gdk.ModifierType.SHIFT_MASK && keycode !== 0) {
        if ((keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
            (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
            (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
            (keyval >= Gdk.KEY_kana_fullstop && keyval <= Gdk.KEY_semivoicedsound) ||
            (keyval >= Gdk.KEY_Arabic_comma && keyval <= Gdk.KEY_Arabic_sukun) ||
            (keyval >= Gdk.KEY_Serbian_dje && keyval <= Gdk.KEY_Cyrillic_HARDSIGN) ||
            (keyval >= Gdk.KEY_Greek_ALPHAaccent && keyval <= Gdk.KEY_Greek_omega) ||
            (keyval >= Gdk.KEY_hebrew_doublelowline && keyval <= Gdk.KEY_hebrew_taf) ||
            (keyval >= Gdk.KEY_Thai_kokai && keyval <= Gdk.KEY_Thai_lekkao) ||
            (keyval >= Gdk.KEY_Hangul_Kiyeog && keyval <= Gdk.KEY_Hangul_J_YeorinHieuh) ||
            (keyval === Gdk.KEY_space && mask === 0))
            return false;
    }
    return true;
}

function isValidAccel(mask, keyval) {
    return Gtk.accelerator_valid(keyval, mask) ||
           (keyval === Gdk.KEY_Tab && mask !== 0);
}

export default class LidAwakePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '단축키',
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: '단축키',
            description: '변경은 즉시 적용됩니다. 다시 로그인할 필요 없습니다.',
        });
        group.add(new ShortcutRow(settings));
        page.add(group);

        window.add(page);
    }
}
