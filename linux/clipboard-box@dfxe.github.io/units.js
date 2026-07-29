// Unit tables for the calculator. Pure data plus two lookups — no GI imports,
// so this stays trivially testable.
//
// Every dimension has a base unit and a factor to it. Temperature is the
// exception: it is affine, not linear, so it carries explicit conversions
// instead of a factor.

const LINEAR = {
    length: {
        base: 'm',
        units: {
            nm: 1e-9, um: 1e-6, µm: 1e-6, mm: 0.001, cm: 0.01, dm: 0.1,
            m: 1, km: 1000,
            in: 0.0254, inch: 0.0254, inches: 0.0254, '"': 0.0254,
            ft: 0.3048, foot: 0.3048, feet: 0.3048, "'": 0.3048,
            yd: 0.9144, yard: 0.9144, yards: 0.9144,
            mi: 1609.344, mile: 1609.344, miles: 1609.344,
            nmi: 1852, ly: 9.4607304725808e15, au: 1.495978707e11,
            parsec: 3.0856775814913673e16, pc: 3.0856775814913673e16,
        },
    },
    mass: {
        base: 'kg',
        units: {
            ug: 1e-9, µg: 1e-9, mg: 1e-6, g: 0.001, kg: 1, t: 1000, tonne: 1000,
            oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125,
            lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237,
            st: 6.35029318, stone: 6.35029318,
            ton: 907.18474, // short ton
        },
    },
    time: {
        base: 's',
        units: {
            ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 0.001,
            s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
            min: 60, mins: 60, minute: 60, minutes: 60,
            h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
            d: 86400, day: 86400, days: 86400,
            wk: 604800, week: 604800, weeks: 604800,
            // Calendar-average, so "1 year in days" gives 365.25 rather than
            // pretending months are uniform.
            mo: 2629800, month: 2629800, months: 2629800,
            yr: 31557600, year: 31557600, years: 31557600,
        },
    },
    data: {
        base: 'B',
        units: {
            b: 0.125, bit: 0.125, bits: 0.125,
            B: 1, byte: 1, bytes: 1,
            kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15,
            KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3,
            TiB: 1024 ** 4, PiB: 1024 ** 5,
        },
        // Data units are the one place where case is meaningful: KB vs kB is
        // cosmetic, but B (byte) vs b (bit) is a factor of eight.
        caseSensitive: true,
    },
    area: {
        base: 'm2',
        units: {
            mm2: 1e-6, cm2: 1e-4, m2: 1, km2: 1e6,
            ha: 1e4, hectare: 1e4, acre: 4046.8564224, acres: 4046.8564224,
            in2: 0.00064516, ft2: 0.09290304, yd2: 0.83612736, mi2: 2589988.110336,
        },
    },
    volume: {
        base: 'l',
        units: {
            ml: 0.001, cl: 0.01, dl: 0.1, l: 1, liter: 1, litre: 1,
            liters: 1, litres: 1, m3: 1000, cm3: 0.001,
            tsp: 0.00492892159375, tbsp: 0.01478676478125,
            floz: 0.0295735295625, cup: 0.2365882365,
            pt: 0.473176473, pint: 0.473176473,
            qt: 0.946352946, quart: 0.946352946,
            gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784,
        },
    },
    speed: {
        base: 'mps',
        units: {
            mps: 1, 'm/s': 1,
            kph: 1 / 3.6, kmh: 1 / 3.6, 'km/h': 1 / 3.6,
            mph: 0.44704, 'mi/h': 0.44704,
            knot: 0.514444, knots: 0.514444, kn: 0.514444,
            fps: 0.3048, 'ft/s': 0.3048,
            c: 299792458,
        },
    },
    angle: {
        base: 'rad',
        units: {
            rad: 1, radian: 1, radians: 1,
            deg: Math.PI / 180, degree: Math.PI / 180, degrees: Math.PI / 180,
            '°': Math.PI / 180,
            grad: Math.PI / 200, turn: 2 * Math.PI,
        },
    },
};

// Affine, so it cannot join the table above.
const TEMPERATURE = {
    c: { to: v => v, from: v => v },
    celsius: { to: v => v, from: v => v },
    '°c': { to: v => v, from: v => v },
    f: { to: v => (v - 32) * 5 / 9, from: v => v * 9 / 5 + 32 },
    fahrenheit: { to: v => (v - 32) * 5 / 9, from: v => v * 9 / 5 + 32 },
    '°f': { to: v => (v - 32) * 5 / 9, from: v => v * 9 / 5 + 32 },
    k: { to: v => v - 273.15, from: v => v + 273.15 },
    kelvin: { to: v => v - 273.15, from: v => v + 273.15 },
};

// Flattened alias -> descriptor, built once. Case-sensitive dimensions get
// their exact spelling registered; everything else is matched lowercased.
const INDEX = new Map();
for (const [dimension, spec] of Object.entries(LINEAR)) {
    for (const [name, factor] of Object.entries(spec.units)) {
        const key = spec.caseSensitive ? name : name.toLowerCase();
        if (!INDEX.has(key)) INDEX.set(key, { dimension, factor, canonical: name });
    }
}

export function lookupUnit(raw) {
    const token = (raw ?? '').trim();
    if (token === '') return null;

    const temp = TEMPERATURE[token.toLowerCase()];
    if (temp) return { dimension: 'temperature', convert: temp, canonical: token };

    // Data units first, exactly as written, so `1 b` (bit) and `1 B` (byte)
    // stay distinct. Note the table carries no bit *multiples* — there is no
    // `Mb`/`Gb` — so only the base unit is actually case-discriminated.
    const exact = INDEX.get(token);
    if (exact && LINEAR[exact.dimension].caseSensitive) return exact;

    return INDEX.get(token.toLowerCase()) ?? exact ?? null;
}

// Convert `value` between two units of the same dimension. Returns null when
// they don't belong together — "5 km in kg" is a question with no answer.
export function convertUnits(value, fromRaw, toRaw) {
    const from = lookupUnit(fromRaw);
    const to = lookupUnit(toRaw);
    if (!from || !to || from.dimension !== to.dimension) return null;

    if (from.dimension === 'temperature')
        return to.convert.from(from.convert.to(value));

    return value * from.factor / to.factor;
}
