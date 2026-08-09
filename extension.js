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

/**
 * Get the system default interface font as a CSS style string
 * @returns {string} CSS style with font-family and font-size, or empty string
 */
function getSystemFontStyle() {
    try {
        const settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const fontName = settings.get_string('font-name'); // e.g. 'Cantarell 11'
        const match = fontName.match(/^(.*?)[\s,]+(\d+(?:\.\d+)?)$/);
        if (match)
            return `font-family: '${match[1].trim()}'; font-size: ${match[2]}pt;`;
    } catch (e) {
        console.error(`IP-Finder: Error reading system font: ${e}`);
    }
    return '';
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
            // Initialize PanelMenu.Button with no menu (false)
            super._init(0.5, 'IP-Finder', false);

            this._extension = extension;

            // Load country flag mappings
            this._countryFlags = loadCountryFlags(this._extension.path);

            // Used to discard stale query results when a newer refresh starts
            this._queryGeneration = 0;

            // Create panel box layout (styled like a panel status button)
            const panelBox = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-status-menu-box panel-button-box ip-finder-panel-box',
                style: 'spacing: 6px;',
            });
            this.add_child(panelBox);

            // VPN status icon
            this._vpnStatusIcon = new St.Icon({
                icon_name: 'changes-allow-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
            });
            panelBox.add_child(this._vpnStatusIcon);

            // IP Address label (uses the system default font)
            this._ipAddressLabel = new St.Label({
                text: 'Loading...',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'ip-finder-ip-label',
                style: getSystemFontStyle(),
            });
            panelBox.add_child(this._ipAddressLabel);

            // Status/loading icon (shown during loading)
            this._statusIcon = new St.Icon({
                icon_name: 'network-wired-acquiring-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
            });
            panelBox.add_child(this._statusIcon);

            // Country flag emoji
            this._flagIcon = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'ip-finder-flag-label',
                visible: false,
            });
            panelBox.add_child(this._flagIcon);

            // Override the default click behavior to just refresh IP
            this.connect('button-press-event', (actor, event) => {
                // Only handle left clicks
                if (event.get_button() === 1) {
                    this._startGetIpInfo();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // Initialize network connectivity
            NM.Client.new_async(null, this.establishNetworkConnectivity.bind(this));
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
        }

        _setIpDetails(data, error) {
            // Handle error or no connection
            if (!data) {
                this._ipAddressLabel.text = error ? `⚠ ${error}` : 'No Connection';
                this._statusIcon.show();
                this._statusIcon.icon_name = 'network-offline-symbolic';
                this._flagIcon.hide();
                this._vpnStatusIcon.hide();
                return;
            }

            // Hide loading icon
            this._statusIcon.hide();

            // Update IP address
            this._ipAddressLabel.text = data.ip;

            // Update flag emoji
            const flagEmoji = getFlagEmoji(data.countryCode, this._countryFlags);
            if (flagEmoji) {
                this._flagIcon.text = flagEmoji;
                this._flagIcon.show();
            } else {
                this._flagIcon.hide();
            }

            // Update VPN icon
            this._vpnStatusIcon.visible = true;
            this._vpnStatusIcon.icon_name = this._vpnConnectionOn ?
                'changes-prevent-symbolic' : 'changes-allow-symbolic';
            this._vpnStatusIcon.style_class = this._vpnConnectionOn ?
                'system-status-icon ip-info-vpn-on' : 'system-status-icon ip-info-vpn-off';
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
