import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const SESSION_SCHEMA = 'org.gnome.desktop.session';

// 활성 시 'nothing' 으로 덮어쓸 gsd-power 키
const POWER_KEYS = [
    'sleep-inactive-ac-type',
    'sleep-inactive-battery-type',
    'lid-close-ac-action',
    'lid-close-battery-action',
];

// logind 에 요청할 block inhibitor 종류
const INHIBIT_WHAT = 'handle-lid-switch:sleep:idle';

// inhibitor 를 들고 있는 transient systemd user unit.
// 셸 프로세스가 아니라 이 유닛이 락의 단일 진실 소스다.
const UNIT = 'lid-awake-inhibit.service';

// 덮개 상태는 logind 가 아니라 UPower 가 프로퍼티로 노출한다.
const UPOWER = {
    name: 'org.freedesktop.UPower',
    path: '/org/freedesktop/UPower',
    iface: 'org.freedesktop.UPower',
};

// 화면만 끄는 통로. gnome-shell 50 부터 별도 프로세스가 이 이름을 잡는다.
const SCREENSAVER = {
    name: 'org.gnome.ScreenSaver',
    path: '/org/gnome/ScreenSaver',
    iface: 'org.gnome.ScreenSaver',
};

const ICON_ON = 'weather-clear-symbolic';
const ICON_OFF = 'weather-clear-night-symbolic';

const Indicator = GObject.registerClass(
class LidAwakeIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Lid Awake');
        this._ext = ext;

        this._icon = new St.Icon({
            icon_name: ICON_OFF,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._toggle = new PopupMenu.PopupSwitchMenuItem('깨어 있기', false);
        this._toggle.connect('toggled', (_item, state) => ext.setActive(state));
        this.menu.addMenuItem(this._toggle);

        this._status = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            style_class: 'popup-inactive-menu-item',
        });
        this.menu.addMenuItem(this._status);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const screenItem = new PopupMenu.PopupSwitchMenuItem(
            '화면도 끄지 않기', ext.settings.get_boolean('keep-screen-on'));
        screenItem.connect('toggled', (_item, state) =>
            ext.settings.set_boolean('keep-screen-on', state));
        this.menu.addMenuItem(screenItem);

        const blankItem = new PopupMenu.PopupSwitchMenuItem(
            '덮으면 화면 끄기', ext.settings.get_boolean('blank-on-lid-close'));
        blankItem.connect('toggled', (_item, state) =>
            ext.settings.set_boolean('blank-on-lid-close', state));
        this.menu.addMenuItem(blankItem);

        const restoreItem = new PopupMenu.PopupSwitchMenuItem(
            '로그인 시 상태 유지', ext.settings.get_boolean('restore-state'));
        restoreItem.connect('toggled', (_item, state) =>
            ext.settings.set_boolean('restore-state', state));
        this.menu.addMenuItem(restoreItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('시스템 전원 설정…');
        prefsItem.connect('activate', () => {
            Gio.Subprocess.new(
                ['gnome-control-center', 'power'], Gio.SubprocessFlags.NONE);
        });
        this.menu.addMenuItem(prefsItem);

        // CLI(systemctl --user stop …)로 밖에서 유닛을 껐을 수도 있으므로
        // 메뉴를 열 때마다 실제 유닛 상태를 다시 읽는다.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                ext.refresh();
        });
    }

    sync(active, detail) {
        this._icon.icon_name = active ? ICON_ON : ICON_OFF;
        // 활성 시 강조
        if (active)
            this._icon.add_style_class_name('lid-awake-active');
        else
            this._icon.remove_style_class_name('lid-awake-active');
        this._toggle.setToggleState(active);
        this._status.label.text = detail;
    }
});

export default class LidAwakeExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._power = new Gio.Settings({schema_id: POWER_SCHEMA});
        this._session = new Gio.Settings({schema_id: SESSION_SCHEMA});

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._watchLid();

        // 유닛이 셸보다 오래 살아남으므로, 시작 시점의 진실은 설정이 아니라 유닛이다.
        if (this._lockRunning()) {
            // 셸이 크래시했다 살아난 경우. 락이 그대로 있으니 상태를 채택하고
            // gsd-power 쪽 덮어쓰기만 다시 맞춰 준다(백업은 건드리지 않는다).
            this.settings.set_boolean('active', true);
            this._writeOverrides();
        } else {
            // 락이 없다 = 절전이 살아 있다. 남아 있는 백업이 있으면 원상 복구.
            this._restoreOriginals();

            const wanted = this.settings.get_boolean('active') &&
                           this.settings.get_boolean('restore-state');
            if (wanted)
                this._apply(true);
            else
                this.settings.set_boolean('active', false);
        }

        this._sync();
    }

    disable() {
        // 잠금화면 진입 시에도 상태를 유지해야 하므로 session-modes 에
        // unlock-dialog 를 넣어 뒀다. 여기 도달했다면 실제 비활성화/로그아웃이다.
        this._apply(false);

        this._unwatchLid();

        this._indicator?.destroy();
        this._indicator = null;
        this._power = null;
        this._session = null;
        this.settings = null;
    }

    setActive(state) {
        this._apply(state);
        this.settings.set_boolean('active', state);
        this._sync();
    }

    // 실제 유닛 상태를 다시 읽어 UI/설정을 맞춘다.
    refresh() {
        const running = this._lockRunning();
        if (running !== this.settings.get_boolean('active')) {
            // 밖에서 유닛이 멈췄다면 덮어써 둔 전원 설정도 되돌려야 한다.
            if (!running)
                this._restoreOriginals();
            this.settings.set_boolean('active', running);
        }
        this._sync();
    }

    // ---- 핵심 동작 ----

    _apply(active) {
        if (active) {
            this._saveOriginals();
            this._writeOverrides();
            this._takeLock();
        } else {
            this._dropLock();
            this._restoreOriginals();
        }
    }

    _writeOverrides() {
        for (const key of POWER_KEYS)
            this._power.set_string(key, 'nothing');
        if (this.settings.get_boolean('keep-screen-on'))
            this._session.set_uint('idle-delay', 0);
    }

    _saveOriginals() {
        // 이미 백업이 있으면 덮어쓰지 않는다(원본 유실 방지).
        if (this.settings.get_string('saved-state') !== '{}')
            return;
        const saved = {power: {}, idleDelay: this._session.get_uint('idle-delay')};
        for (const key of POWER_KEYS)
            saved.power[key] = this._power.get_string(key);
        this.settings.set_string('saved-state', JSON.stringify(saved));
    }

    _restoreOriginals() {
        const raw = this.settings.get_string('saved-state');
        if (raw === '{}')
            return;
        try {
            const saved = JSON.parse(raw);
            for (const [key, value] of Object.entries(saved.power ?? {}))
                this._power.set_string(key, value);
            if (saved.idleDelay !== undefined)
                this._session.set_uint('idle-delay', saved.idleDelay);
        } catch (e) {
            logError(e, 'lid-awake: 백업 복원 실패');
        }
        this.settings.set_string('saved-state', '{}');
    }

    // ---- systemd transient unit 으로 락 관리 ----
    //
    // 셸 프로세스가 fd 를 직접 들고 있으면 셸이 크래시할 때 락도 같이 사라져
    // 사용자 모르게 절전이 되살아난다. 별도 유닛에 맡기면 락이 살아남고,
    // 로그아웃 때는 user manager 가 유닛을 정리하므로 기본 동작으로 돌아간다.

    _lockRunning() {
        return this._spawn(
            ['systemctl', '--user', 'is-active', '--quiet', UNIT]) === 0;
    }

    _takeLock() {
        if (this._lockRunning())
            return;
        const status = this._spawn([
            'systemd-run', '--user', '--collect', `--unit=${UNIT}`,
            '--description=Lid Awake: 덮개 닫힘·유휴 절전 차단',
            'systemd-inhibit',
            `--what=${INHIBIT_WHAT}`,
            '--who=Lid Awake',
            '--why=사용자가 깨어 있기를 켰음',
            '--mode=block',
            'sleep', 'infinity',
        ]);
        if (status !== 0)
            log(`lid-awake: inhibitor 유닛 시작 실패 (exit ${status})`);
    }

    _dropLock() {
        if (!this._lockRunning())
            return;
        const status = this._spawn(['systemctl', '--user', 'stop', UNIT]);
        if (status !== 0)
            log(`lid-awake: inhibitor 유닛 정지 실패 (exit ${status})`);
    }

    // ---- 덮개 감시: 잠들지는 않되 화면만 끄기 ----
    //
    // 절전을 막아 두면 mutter 가 유일한 내장 패널을 끄지 않아 덮어도 화면이 켜져
    // 있다. logind 쪽 idle inhibitor 도 gsd-power 의 blank 와는 무관하다.
    // 그래서 덮개가 닫히는 순간 스크린세이버를 직접 켜서 화면만 내린다.

    _watchLid() {
        try {
            this._upower = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                UPOWER.name, UPOWER.path, UPOWER.iface, null);
        } catch (e) {
            logError(e, 'lid-awake: UPower 연결 실패');
            return;
        }

        this._lidClosed = this._lidState() ?? false;
        this._lidId = this._upower.connect('g-properties-changed',
            (_proxy, changed) => {
                if (!changed.lookup_value('LidIsClosed', null))
                    return;
                const closed = this._lidState();
                if (closed === null || closed === this._lidClosed)
                    return;
                this._lidClosed = closed;
                this._onLidChanged(closed);
            });
    }

    _unwatchLid() {
        if (this._lidId)
            this._upower?.disconnect(this._lidId);
        this._lidId = null;
        this._upower = null;
    }

    _lidState() {
        const v = this._upower?.get_cached_property('LidIsClosed');
        return v ? v.get_boolean() : null;
    }

    _onLidChanged(closed) {
        // 확장이 꺼져 있으면 시스템 기본 동작(대개 서스펜드)에 맡긴다.
        if (!this.settings.get_boolean('active'))
            return;
        if (!this.settings.get_boolean('blank-on-lid-close'))
            return;
        // '화면도 끄지 않기'가 켜져 있으면 그쪽 의사가 우선이다.
        if (this.settings.get_boolean('keep-screen-on'))
            return;

        // 열 때는 꺼 준다. 덮개 열림 자체는 입력 이벤트가 아니라서
        // 이걸 안 하면 키를 누를 때까지 화면이 검은 채로 남는다.
        this._setScreensaver(closed);
    }

    _setScreensaver(active) {
        Gio.DBus.session.call(
            SCREENSAVER.name, SCREENSAVER.path, SCREENSAVER.iface, 'SetActive',
            new GLib.Variant('(b)', [active]), null,
            Gio.DBusCallFlags.NONE, -1, null,
            (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    logError(e, 'lid-awake: 스크린세이버 전환 실패');
                }
            });
    }

    // 짧게 끝나는 systemd 명령이라 동기 실행해도 셸이 눈에 띄게 멈추지 않는다.
    _spawn(argv) {
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait(null);
            return proc.get_exit_status();
        } catch (e) {
            logError(e, `lid-awake: ${argv[0]} 실행 실패`);
            return -1;
        }
    }

    _sync() {
        const active = this.settings.get_boolean('active');
        const detail = active
            ? (this._lockRunning() ? '덮개 닫힘·유휴 절전 차단됨' : '차단 실패 — 로그 확인')
            : '시스템 기본 동작';
        this._indicator?.sync(active, detail);
    }
}
