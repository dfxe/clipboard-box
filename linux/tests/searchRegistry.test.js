import { runSearch, totalResults } from '../omelette@dfxe.github.io/searchRegistry.js';
import { suite, it, eq, ok, silenced } from './harness.js';

suite('searchRegistry');

const provider = (id, results, extra = {}) =>
    ({ id, title: id, cap: 5, search: () => results, ...extra });

it('emits one group per provider, in provider order', () => {
    const groups = runSearch(
        [provider('a', [{ id: 1 }]), provider('b', [{ id: 2 }])], 'q', {});
    eq(groups.map(g => g.provider.id), ['a', 'b']);
});

it('applies each provider cap', () => {
    const p = provider('big', [1, 2, 3, 4, 5, 6, 7].map(id => ({ id })));
    p.cap = 3;
    eq(runSearch([p], 'q', {})[0].results.length, 3);
});

it('a provider that throws in search() is isolated from the others', () => {
    const boom = { id: 'boom', title: 'Boom', cap: 5, search: () => { throw new Error('x'); } };
    const groups = silenced(() => runSearch([boom, provider('good', [{ id: 1 }])], 'q', {}));
    eq(groups.map(g => g.provider.id), ['good']);
});

it('a provider that throws in emptyMessage() no longer kills the whole search', () => {
    const boom = {
        id: 'boom', title: 'Boom', cap: 5,
        search: () => [],
        emptyMessage: () => { throw new Error('x'); },
    };
    const groups = silenced(() => runSearch([boom, provider('good', [{ id: 1 }])], '', {}));
    eq(groups.map(g => g.provider.id), ['good']);
});

it('empty sections are hidden entirely once a query is typed', () => {
    const p = provider('empty', [], { emptyMessage: () => 'nothing here' });
    eq(runSearch([p], 'query', {}).length, 0);
});

it('empty sections may speak while browsing', () => {
    const p = provider('empty', [], { emptyMessage: () => 'nothing here' });
    const groups = runSearch([p], '', {});
    eq(groups.length, 1);
    eq(groups[0].emptyMessage, 'nothing here');
    eq(groups[0].results.length, 0);
});

it('a provider with nothing to say stays silent while browsing', () => {
    eq(runSearch([provider('quiet', [])], '', {}).length, 0);
});

it('a provider returning null is treated as returning nothing', () => {
    const p = { id: 'nully', title: 'N', cap: 5, search: () => null };
    eq(runSearch([p], 'q', {}).length, 0);
});

it('totalResults counts across groups and ignores empty-message groups', () => {
    const groups = runSearch([
        provider('a', [{ id: 1 }, { id: 2 }]),
        provider('b', [{ id: 3 }]),
    ], 'q', {});
    eq(totalResults(groups), 3);
    ok(totalResults([]) === 0);
});
