import { lookupUnit, convertUnits } from '../omelette@dfxe.github.io/units.js';
import { suite, it, eq, ok } from './harness.js';

suite('units');

const near = (actual, expected, tol, label) =>
    ok(Math.abs(actual - expected) < tol,
        `${label ?? ''} expected ~${expected}, got ${actual}`);

it('converts length', () => {
    near(convertUnits(100, 'km', 'mi'), 62.137119, 1e-5);
    near(convertUnits(1, 'in', 'cm'), 2.54, 1e-9);
    near(convertUnits(1, 'mile', 'm'), 1609.344, 1e-9);
});

it('converts mass and time', () => {
    near(convertUnits(1, 'kg', 'lb'), 2.2046226, 1e-6);
    near(convertUnits(90, 'min', 'h'), 1.5, 1e-12);
});

it('converts temperature affinely, not by a factor', () => {
    near(convertUnits(72, 'f', 'c'), 22.2222, 1e-3);
    near(convertUnits(0, 'c', 'f'), 32, 1e-9);
    near(convertUnits(100, 'c', 'k'), 373.15, 1e-9);
    // The affine offset is the whole point: 0°C is not 0°F.
    ok(convertUnits(0, 'c', 'f') !== 0);
});

it('keeps bits and bytes distinct by case', () => {
    near(convertUnits(1, 'B', 'b'), 8, 1e-9, 'one byte is eight bits');
    near(convertUnits(8, 'b', 'B'), 1, 1e-9);
    near(convertUnits(1, 'MB', 'b'), 8e6, 1);
});

// The case-sensitive data table distinguishes the *base* units b/B. It carries
// no bit multiples, so these are not units at all rather than being aliases of
// the byte multiples — which would silently be wrong by a factor of eight.
it('has no bit multiples, and does not quietly alias them to bytes', () => {
    eq(lookupUnit('Mb'), null);
    eq(lookupUnit('kb'), null);
    eq(lookupUnit('Gb'), null);
    eq(convertUnits(1, 'Mb', 'b'), null);
});

it('handles binary prefixes', () => {
    near(convertUnits(2.5, 'GiB', 'MB'), 2684.35456, 1e-5);
    near(convertUnits(1, 'KiB', 'B'), 1024, 1e-9);
});

it('refuses cross-dimension conversions rather than inventing a number', () => {
    eq(convertUnits(5, 'km', 'kg'), null);
    eq(convertUnits(5, 'c', 'm'), null);
    eq(convertUnits(5, 'nonsense', 'm'), null);
});

it('lookupUnit is forgiving about case and spacing but not about junk', () => {
    ok(lookupUnit('KM') !== null);
    ok(lookupUnit('  m  ') !== null);
    eq(lookupUnit(''), null);
    eq(lookupUnit(null), null);
    eq(lookupUnit('zzz'), null);
});

it('accepts the spelled-out and symbol aliases', () => {
    near(convertUnits(1, 'feet', 'in'), 12, 1e-9);
    near(convertUnits(1, "'", '"'), 12, 1e-9);
    near(convertUnits(1, 'pounds', 'oz'), 16, 1e-6);
});

it('round-trips without drifting', () => {
    near(convertUnits(convertUnits(123.456, 'km', 'mi'), 'mi', 'km'), 123.456, 1e-9);
    near(convertUnits(convertUnits(37, 'c', 'f'), 'f', 'c'), 37, 1e-9);
});
