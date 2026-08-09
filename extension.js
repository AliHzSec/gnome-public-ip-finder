import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';
import St from 'gi://St';

import { loadInterfaceXML } from 'resource:///org/gnome/shell/misc/fileUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Utils from './utils.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const PortalHelperIface = loadInterfaceXML('org.gnome.Shell.PortalHelper');
const PortalHelperInfo = Gio.DBusInterfaceInfo.new_for_xml(PortalHelperIface);

const PortalHelperResult = {
    CANCELLED: 0,
    COMPLETED: 1,
    RECHECK: 2,
};

// Optimized refresh interval (in milliseconds)
const REFRESH_DELAY = 1500;

// Retry configuration for the DNS query
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// Bundled font: family name and the directory (relative to the extension)
// that contains the .ttf files.
const BUNDLED_FONT_FAMILY = 'Victor Mono';
const BUNDLED_FONT_SUBDIR = 'fonts/VictorMono';

// Preferred shield icons for the VPN state, most-preferred first. Different
// icon themes ship different names, so the actual icon is resolved at runtime
// against the current theme, falling back to the padlock icons if needed.
const VPN_ICON_ON_CANDIDATES = [
    'security-high-symbolic',
    'network-vpn-symbolic',
    'channel-secure-symbolic',
    'changes-prevent-symbolic',
];
const VPN_ICON_OFF_CANDIDATES = [
    'security-low-symbolic',
    'network-vpn-disabled-symbolic',
    'channel-insecure-symbolic',
    'changes-allow-symbolic',
];

/**
 * Resolve the first icon name that exists in the current icon theme.
 * @param {string[]} candidates - Icon names ordered by preference
 * @param {string} fallback - Name to use if none of the candidates exist
 * @param {St.IconTheme|null} theme - Icon theme to query, or null
 * @returns {string} A usable icon name
 */
function resolveIcon(candidates, fallback, theme) {
    if (theme) {
        for (const name of candidates) {
            try {
                if (theme.has_icon(name))
                    return name;
            } catch (e) {
                // Ignore and try the next candidate
            }
        }
    }
    return fallback;
}

/**
 * Get only the system interface font size as a CSS style string.
 * The IP label uses Victor Mono (from CSS) but should match the system font
 * size; the flag label reuses it so the emoji scales to the text.
 * @returns {string} e.g. 'font-size: 11pt;' or empty string
 */
function getSystemFontSizeStyle() {
    try {
        const settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const fontName = settings.get_string('font-name'); // e.g. 'Cantarell 11'
        const match = fontName.match(/^(.*?)[\s,]+(\d+(?:\.\d+)?)$/);
        if (match)
            return `font-size: ${match[2]}pt;`;
    } catch (e) {
        console.error(`IP-Finder: Error reading system font: ${e}`);
    }
    return '';
}

/**
 * Copy the bundled fonts into the user font directory (idempotently) and
 * refresh the font cache so Pango can resolve them. If Victor Mono is still
 * unavailable, the CSS font stack falls back to the system monospace font.
 * @param {string} extensionPath - Path to the extension directory
 */
function installBundledFonts(extensionPath) {
    try {
        const srcDir = Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, ...BUNDLED_FONT_SUBDIR.split('/')]));
        if (!srcDir.query_exists(null))
            return;

        const destDirPath = GLib.build_filenamev(
            [GLib.get_home_dir(), '.local', 'share', 'fonts']);
        const destDir = Gio.File.new_for_path(destDirPath);
        try {
            destDir.make_directory_with_parents(null);
        } catch (e) {
            // Directory already exists: ignore
        }

        let copiedAny = false;
        const enumerator = srcDir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.toLowerCase().endsWith('.ttf'))
                continue;
            const dest = destDir.get_child(name);
            if (dest.query_exists(null))
                continue;
            srcDir.get_child(name).copy(dest, Gio.FileCopyFlags.NONE, null, null);
            copiedAny = true;
        }
        enumerator.close(null);

        if (copiedAny) {
            const fcCache = GLib.find_program_in_path('fc-cache');
            if (fcCache) {
                const proc = Gio.Subprocess.new(
                    [fcCache, '-f', destDirPath],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.wait_async(null, null);
            }
        }
    } catch (e) {
        console.error(`IP-Finder: Error installing bundled fonts: ${e}`);
    }
}

/**
 * Promise-based delay helper
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Load flag emojis from countries.json
 * @param {string} extensionPath - Path to extension directory
 * @returns {object} Country code to flag emoji mapping
 */
function loadCountryFlags(extensionPath) {
    try {
        const file = Gio.File.new_for_path(`${extensionPath}/countries.json`);
        const [success, contents] = file.load_contents(null);
        if (success) {
            const decoder = new TextDecoder('utf-8');
            return JSON.parse(decoder.decode(contents));
        }
    } catch (e) {
        console.error(`IP-Finder: Error loading countries.json: ${e}`);
    }
    return {};
}

/**
 * Get flag emoji for a country code
 * @param {string} countryCode - Two-letter country code
 * @param {object} flagMap - Country code to flag emoji mapping
 * @returns {string} Flag emoji or empty string
 */
function getFlagEmoji(countryCode, flagMap) {
    if (!countryCode || !flagMap) return '';
    return flagMap[countryCode.toUpperCase()] || '';
}

// Simplified Panel Button - no menu, just click to refresh
var IPFinderPanelButton = GObject.registerClass(
    class IPFinderPanelButton extends PanelMenu.Button {
        _init(extension) {
            // Initialize PanelMenu.Button. Pass true to skip creating a menu:
            // there is none, and skipping it stops the shell's default press
            // handler from toggling an empty popup and swallowing our clicks.
            super._init(0.5, 'IP-Finder', true);

            // Scopes the hover/focus/active override in stylesheet.css to
            // just this button, so GNOME Shell's default panel-button
            // highlight doesn't show a second border on hover.
            this.add_style_class_name('ip-finder-button');

            this._extension = extension;

            // Set once we have a valid IP; used by the click-to-copy handler.
            // Stays null while loading, on error, or with no connection.
            this._currentIp = null;

            // Make the bundled monospace font available (idempotent).
            installBundledFonts(this._extension.path);

            // Load country flag mappings
            this._countryFlags = loadCountryFlags(this._extension.path);

            // Resolve the best available shield icons for this icon theme.
            let iconTheme = null;
            try {
                iconTheme = new St.IconTheme();
            } catch (e) {
                console.error(`IP-Finder: Could not create icon theme: ${e}`);
            }
            this._vpnIconOn = resolveIcon(VPN_ICON_ON_CANDIDATES, 'changes-prevent-symbolic', iconTheme);
            this._vpnIconOff = resolveIcon(VPN_ICON_OFF_CANDIDATES, 'changes-allow-symbolic', iconTheme);

            // Cache the system font size; shared by the IP and flag labels so
            // the row height stays consistent and the items stay aligned.
            this._fontSizeStyle = getSystemFontSizeStyle();

            // Used to discard stale query results when a newer refresh starts
            this._queryGeneration = 0;

            // Create panel box layout (styled like a panel status button).
            // Kept on `this` so its VPN-state border class can be toggled.
            // 'spacing' is a valid St.BoxLayout property set inline here.
            this._panelBox = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-status-menu-box panel-button-box ip-finder-panel-box',
                style: 'spacing: 12px;',
            });
            this.add_child(this._panelBox);

            // VPN status icon (shield)
            this._vpnStatusIcon = new St.Icon({
                icon_name: this._vpnIconOff,
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
            });
            this._panelBox.add_child(this._vpnStatusIcon);

            // IP Address label (Victor Mono via CSS, system font size via style)
            this._ipAddressLabel = new St.Label({
                text: 'Loading...',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'ip-finder-ip-label',
                style: this._fontSizeStyle,
            });
            this._panelBox.add_child(this._ipAddressLabel);

            // Status/loading icon (shown during loading)
            this._statusIcon = new St.Icon({
                icon_name: 'network-wired-acquiring-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
            });
            this._panelBox.add_child(this._statusIcon);

            // Country flag emoji. Reuse the system font size so the emoji is
            // scaled to match the text height instead of the default size.
            this._flagIcon = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'ip-finder-flag-label',
                style: this._fontSizeStyle,
                visible: false,
            });
            this._panelBox.add_child(this._flagIcon);

            // Left click: silently copy the current IP to the clipboard.
            // Right click: manually trigger a refresh. The automatic refresh
            // mechanism is untouched; this only adds an on-demand refresh.
            // No notification or visual feedback is shown for the copy.
            this.connect('button-press-event', (actor, event) => {
                const button = event.get_button();
                if (button === 1) {
                    this._copyCurrentIpToClipboard();
                    return Clutter.EVENT_STOP;
                }
                if (button === 3) {
                    this._startGetIpInfo();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // Initialize network connectivity
            NM.Client.new_async(null, this.establishNetworkConnectivity.bind(this));
        }

        /**
         * Silently copy the current IP address to the clipboard. No-op if
         * no valid IP is currently displayed (loading, error, no connection).
         */
        _copyCurrentIpToClipboard() {
            if (!this._currentIp)
                return;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, this._currentIp);
        }

        /**
         * Toggle the pill border color to reflect the VPN state (design B).
         * @param {('on'|'off'|null)} state - VPN state, or null to clear.
         */
        _setVpnBorderState(state) {
            this._panelBox.remove_style_class_name('ip-finder-vpn-on');
            this._panelBox.remove_style_class_name('ip-finder-vpn-off');
            if (state === 'on')
                this._panelBox.add_style_class_name('ip-finder-vpn-on');
            else if (state === 'off')
                this._panelBox.add_style_class_name('ip-finder-vpn-off');
        }

        establishNetworkConnectivity(obj, result) {
            this._client = NM.Client.new_finish(result);
            this._connectivityQueue = new Set();
            this._mainConnection = null;

            this._client.connectObject(
                'notify::primary-connection', () => this._syncMainConnection(),
                'notify::activating-connection', () => this._syncMainConnection(),
                'notify::active-connections', () => this._syncMainConnection(),
                'notify::connectivity', () => this._syncConnectivity(),
                this);
            this._syncMainConnection();
        }

        _syncMainConnection() {
            this._setAcquiringDetails();
            this._mainConnection?.disconnectObject(this);

            this._mainConnection =
                this._client.get_primary_connection() ||
                this._client.get_activating_connection();

            if (this._mainConnection) {
                this._mainConnection.connectObject('notify::state',
                    this._mainConnectionStateChanged.bind(this), this);
                this._mainConnectionStateChanged();
            }

            this._syncConnectivity();
        }

        _mainConnectionStateChanged() {
            if (this._mainConnection.state === NM.ActiveConnectionState.ACTIVATED)
                this._startGetIpInfo();
        }

        _startGetIpInfo() {
            // Invalidate any in-flight query so its result is discarded
            this._queryGeneration++;
            this._removeGetIpInfoId();
            this._setAcquiringDetails();

            this._getIpInfoId = GLib.timeout_add(0, REFRESH_DELAY, () => {
                this._getIpInfo().catch(err => console.error(`IP-Finder: ${err}`));
                this._getIpInfoId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        _removeGetIpInfoId() {
            if (this._getIpInfoId) {
                GLib.source_remove(this._getIpInfoId);
                this._getIpInfoId = null;
            }
        }

        _flushConnectivityQueue() {
            for (const item of this._connectivityQueue)
                this._portalHelperProxy?.CloseAsync(item);
            this._connectivityQueue.clear();
        }

        _closeConnectivityCheck(path) {
            if (this._connectivityQueue.delete(path))
                this._portalHelperProxy?.CloseAsync(path);
        }

        async _portalHelperDone(proxy, emitter, parameters) {
            const [path, result] = parameters;

            if (result === PortalHelperResult.CANCELLED) {
                this._setIpDetails();
            } else if (result === PortalHelperResult.COMPLETED) {
                this._startGetIpInfo();
                this._closeConnectivityCheck(path);
            } else if (result === PortalHelperResult.RECHECK) {
                this._setIpDetails();
                try {
                    const state = await this._client.check_connectivity_async(null);
                    if (state >= NM.ConnectivityState.FULL) {
                        this._startGetIpInfo();
                        this._closeConnectivityCheck(path);
                    }
                } catch (e) { }
            } else {
                this._setIpDetails(null, `Invalid result from portal helper: ${result}`);
            }
        }

        async _syncConnectivity() {
            if (this._client.get_active_connections().length < 1 || this._client.connectivity === NM.ConnectivityState.NONE)
                this._setIpDetails();

            if (this._mainConnection == null ||
                this._mainConnection.state !== NM.ActiveConnectionState.ACTIVATED) {
                this._setIpDetails();
                this._flushConnectivityQueue();
                return;
            }

            let isPortal = this._client.connectivity === NM.ConnectivityState.PORTAL;
            if (GLib.getenv('GNOME_SHELL_CONNECTIVITY_TEST') != null)
                isPortal ||= this._client.connectivity < NM.ConnectivityState.FULL;
            if (!isPortal)
                return;

            const path = this._mainConnection.get_path();
            if (this._connectivityQueue.has(path))
                return;

            const timestamp = global.get_current_time();
            if (!this._portalHelperProxy) {
                this._portalHelperProxy = new Gio.DBusProxy({
                    g_connection: Gio.DBus.session,
                    g_name: 'org.gnome.Shell.PortalHelper',
                    g_object_path: '/org/gnome/Shell/PortalHelper',
                    g_interface_name: PortalHelperInfo.name,
                    g_interface_info: PortalHelperInfo,
                });
                this._portalHelperProxy.connectSignal('Done',
                    () => this._portalHelperDone().catch(logError));

                try {
                    await this._portalHelperProxy.init_async(
                        GLib.PRIORITY_DEFAULT, null);
                } catch (e) {
                    console.error(`IP-Finder: Error launching portal helper: ${e.message}`);
                }
            }

            this._portalHelperProxy?.AuthenticateAsync(path, this._client.connectivity_check_uri, timestamp).catch(logError);
            this._connectivityQueue.add(path);
        }

        async _getIpInfo() {
            this._setAcquiringDetails();

            const generation = this._queryGeneration;

            this._vpnConnectionOn = false;

            if (this._client.connectivity === NM.ConnectivityState.NONE) {
                this._setIpDetails();
                return;
            }

            // Detect VPN connections
            const handledTypes = ['vpn', 'wireguard', 'tun'];
            const activeConnections = this._client.get_active_connections() || [];

            activeConnections.forEach(connection => {
                if (connection.state === NM.ActiveConnectionState.ACTIVATED &&
                    handledTypes.includes(connection.type)) {
                    this._vpnConnectionOn = true;
                }
            });

            if (activeConnections.length < 1) {
                this._setIpDetails();
                return;
            }

            // Fetch IP details via DNS query, retrying up to MAX_ATTEMPTS times
            let lastError = 'Unknown error';
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const { data, error } = await Utils.getIPDetails();

                // A newer refresh was requested while querying, discard this result
                if (generation !== this._queryGeneration)
                    return;

                if (data) {
                    this._setIpDetails(data);
                    return;
                }

                lastError = error || 'Unknown error';
                console.log(`IP-Finder: Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError}`);

                if (attempt < MAX_ATTEMPTS)
                    await delay(RETRY_DELAY_MS);
            }

            this._setIpDetails(null, lastError);
        }

        _setAcquiringDetails() {
            this._flagIcon.hide();
            this._statusIcon.show();
            this._ipAddressLabel.text = 'Loading...';
            this._statusIcon.icon_name = 'network-wired-acquiring-symbolic';
            this._vpnStatusIcon.hide();
            // Neutral border while state is unknown.
            this._setVpnBorderState(null);
            // No valid IP to copy while loading.
            this._currentIp = null;
        }

        _setIpDetails(data, error) {
            // Handle error or no connection
            if (!data) {
                this._ipAddressLabel.text = error ? `⚠ ${error}` : 'No Connection';
                this._statusIcon.show();
                this._statusIcon.icon_name = 'network-offline-symbolic';
                this._flagIcon.hide();
                this._vpnStatusIcon.hide();
                this._setVpnBorderState(null);
                // No valid IP to copy on error / no connection.
                this._currentIp = null;
                return;
            }

            // Hide loading icon
            this._statusIcon.hide();

            // Update IP address
            this._ipAddressLabel.text = data.ip;
            this._currentIp = data.ip;

            // Update flag emoji
            const flagEmoji = getFlagEmoji(data.countryCode, this._countryFlags);
            if (flagEmoji) {
                this._flagIcon.text = flagEmoji;
                this._flagIcon.show();
            } else {
                this._flagIcon.hide();
            }

            // Update shield icon and pill border to reflect the VPN state
            this._vpnStatusIcon.visible = true;
            this._vpnStatusIcon.icon_name = this._vpnConnectionOn ? this._vpnIconOn : this._vpnIconOff;
            this._vpnStatusIcon.style_class = this._vpnConnectionOn ?
                'system-status-icon ip-info-vpn-on' : 'system-status-icon ip-info-vpn-off';
            this._setVpnBorderState(this._vpnConnectionOn ? 'on' : 'off');
        }

        disable() {
            this._queryGeneration++;
            this._removeGetIpInfoId();
            this._client?.disconnectObject(this);
        }
    });

export default class IpFinder extends Extension {
    enable() {
        this._panelButton = new IPFinderPanelButton(this);
        Main.panel.addToStatusArea('ip-finder', this._panelButton, 1, 'right');
    }

    disable() {
        this._panelButton.disable();
        this._panelButton.destroy();
        this._panelButton = null;
    }
}