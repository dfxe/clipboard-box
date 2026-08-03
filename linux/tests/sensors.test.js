import {
    devicesFromManagedObjects, fansFromReadings, iconForDevice, formatRpm,
} from '../omelette@dfxe.github.io/sensors.js';
import { suite, it, eq, ok } from './harness.js';

suite('sensors');

// The shape GetManagedObjects returns after recursiveUnpack, trimmed from a
// real adapter: one connected mouse that reports a battery, two paired-but-idle
// headphones, one connected speaker with no Battery1 at all, and a GATT child
// object hanging off the mouse. Everything the filter has to get right is here.
const MANAGED = {
    '/org/bluez/hci0': {
        'org.bluez.Adapter1': { Address: '14:13:33:58:D8:2A', Powered: true },
    },
    '/org/bluez/hci0/dev_DE_05_3F_D3_A5_7A': {
        'org.bluez.Device1': {
            Address: 'DE:05:3F:D3:A5:7A', Alias: 'MX Master 3S',
            Icon: 'input-mouse', Connected: true, Paired: true,
        },
        'org.bluez.Battery1': { Percentage: 85, Source: 'GATT Battery Service' },
    },
    '/org/bluez/hci0/dev_DE_05_3F_D3_A5_7A/service001b': {
        'org.bluez.GattService1': { UUID: '0000180f-0000-1000-8000-00805f9b34fb' },
    },
    '/org/bluez/hci0/dev_B8_17_43_60_AE_AF': {
        'org.bluez.Device1': {
            Address: 'B8:17:43:60:AE:AF', Alias: 'JBL Tune 525BT',
            Icon: 'audio-headphones', Connected: false, Paired: true,
        },
    },
    '/org/bluez/hci0/dev_E8_26_CF_2E_09_CB': {
        'org.bluez.Device1': {
            Address: 'E8:26:CF:2E:09:CB', Alias: "Dragos' JBL Boombox 3",
            Icon: 'audio-card', Connected: true, Paired: true,
        },
        'org.bluez.MediaControl1': { Connected: true },
    },
};

it('keeps only connected devices that report a battery', () => {
    eq(devicesFromManagedObjects(MANAGED).map(d => d.name), ['MX Master 3S']);
});

it('reads the percentage and the object path', () => {
    const [mouse] = devicesFromManagedObjects(MANAGED);
    eq(mouse.percent, 85);
    eq(mouse.path, '/org/bluez/hci0/dev_DE_05_3F_D3_A5_7A');
    eq(mouse.address, 'DE:05:3F:D3:A5:7A');
});

it("maps BlueZ's icon hint onto a symbolic icon name", () => {
    eq(devicesFromManagedObjects(MANAGED)[0].icon, 'input-mouse-symbolic');
    eq(iconForDevice({ Icon: 'audio-headphones' }), 'audio-headphones-symbolic');
});

it('falls back to a generic icon when BlueZ offers no hint', () => {
    eq(iconForDevice({}), 'bluetooth-symbolic');
    eq(iconForDevice(null), 'bluetooth-symbolic');
});

it('prefers Alias, then Name, then the address', () => {
    const named = {
        '/d': {
            'org.bluez.Device1': { Address: 'AA:BB', Name: 'Plain', Connected: true },
            'org.bluez.Battery1': { Percentage: 10 },
        },
    };
    eq(devicesFromManagedObjects(named)[0].name, 'Plain');

    const bare = {
        '/d': {
            'org.bluez.Device1': { Address: 'AA:BB', Connected: true },
            'org.bluez.Battery1': { Percentage: 10 },
        },
    };
    eq(devicesFromManagedObjects(bare)[0].name, 'AA:BB');
});

it('clamps a percentage outside 0–100 rather than drawing past a full turn', () => {
    const odd = {
        '/hi': {
            'org.bluez.Device1': { Alias: 'Hi', Connected: true },
            'org.bluez.Battery1': { Percentage: 140 },
        },
        '/lo': {
            'org.bluez.Device1': { Alias: 'Lo', Connected: true },
            'org.bluez.Battery1': { Percentage: -5 },
        },
    };
    eq(devicesFromManagedObjects(odd).map(d => d.percent), [100, 0]);
});

it('ignores a Battery1 whose percentage is missing or not a number', () => {
    const broken = {
        '/a': {
            'org.bluez.Device1': { Alias: 'A', Connected: true },
            'org.bluez.Battery1': { Source: 'GATT' },
        },
        '/b': {
            'org.bluez.Device1': { Alias: 'B', Connected: true },
            'org.bluez.Battery1': { Percentage: 'lots' },
        },
    };
    eq(devicesFromManagedObjects(broken).length, 0);
});

it('sorts devices by name so the list does not reshuffle between calls', () => {
    const many = {
        '/z': {
            'org.bluez.Device1': { Alias: 'Zeta', Connected: true },
            'org.bluez.Battery1': { Percentage: 50 },
        },
        '/a': {
            'org.bluez.Device1': { Alias: 'Alpha', Connected: true },
            'org.bluez.Battery1': { Percentage: 50 },
        },
    };
    eq(devicesFromManagedObjects(many).map(d => d.name), ['Alpha', 'Zeta']);
});

it('treats a missing object set as no devices', () => {
    eq(devicesFromManagedObjects(null), []);
    eq(devicesFromManagedObjects({}), []);
});

// --- Fans -----------------------------------------------------------------

it('reads labelled fans, sorted by label', () => {
    const fans = fansFromReadings([
        { id: 'hwmon6:fan2', chip: 'asus', index: '2', label: 'gpu_fan', rpm: 3400 },
        { id: 'hwmon6:fan1', chip: 'asus', index: '1', label: 'cpu_fan', rpm: 3100 },
    ]);
    eq(fans.map(f => f.label), ['cpu_fan', 'gpu_fan']);
    eq(fans.map(f => f.rpm), [3100, 3400]);
});

it('names an unlabelled fan after its chip and channel', () => {
    const fans = fansFromReadings([
        { id: 'hwmon2:fan1', chip: 'thinkpad', index: '1', label: null, rpm: 2600 },
    ]);
    eq(fans[0].label, 'thinkpad fan1');
});

it('drops fans reading zero, and unreadable ones', () => {
    const fans = fansFromReadings([
        { id: 'a', chip: 'x', index: '1', label: 'stopped', rpm: 0 },
        { id: 'b', chip: 'x', index: '2', label: 'unreadable', rpm: NaN },
        { id: 'c', chip: 'x', index: '3', label: 'spinning', rpm: 1200 },
    ]);
    eq(fans.map(f => f.label), ['spinning']);
});

it('rounds a fractional reading', () => {
    eq(fansFromReadings([{ id: 'a', label: 'f', rpm: 3399.6 }])[0].rpm, 3400);
});

it('treats missing readings as no fans', () => {
    eq(fansFromReadings(null), []);
    eq(fansFromReadings([]), []);
});

it('formats RPM for display', () => {
    eq(formatRpm(3400), '3400 RPM');
    ok(formatRpm(0) === '0 RPM');
});
