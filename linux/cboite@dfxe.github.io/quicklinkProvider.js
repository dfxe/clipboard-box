// Quicklinks: keyword-prefixed searches that open in the browser.
//
//   "gh cboite"  ->  github.com/search?q=cboite
//   "github"            ->  matches the quicklink by name
//
// Unlike every other provider this one doesn't touch the clipboard — opening a
// link isn't a copy, so nothing is stored and nothing is pasted.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { loadQuicklinks, bumpQuicklink, buildUrl } from './configStore.js';
import { scoreAnyPre, normalize, byScore, NO_MATCH } from './match.js';

const DEFAULT_SEARCH_URL = 'https://duckduckgo.com/?q={query}';

function open(url) {
    try {
        Gio.AppInfo.launch_default_for_uri(url, null);
    } catch (e) {
        Main.notifyError('cBoite', e.message ?? String(e));
    }
}

function linkResult(link, args, matchScore, index) {
    const url = buildUrl(link.url, args);
    const hasArgs = args !== null && args !== '';
    return {
        id: `quicklink:${link.id}:${hasArgs ? 'args' : 'bare'}`,
        score: matchScore,
        tiebreak: link.uses,
        index,
        title: hasArgs ? `${link.name}: ${args}` : link.name,
        subtitle: hasArgs ? url : (link.keyword ? `${link.keyword} …` : link.url),
        visual: { kind: 'icon', name: 'web-browser-symbolic', size: 32 },
        accel: 'Open',
        run: ctx => {
            open(url);
            bumpQuicklink(ctx.settings, link.id);
            // No flash — the popup closes and a browser window comes up, which
            // is feedback enough.
            return { close: true };
        },
    };
}

export const quicklinkProvider = {
    id: 'quicklink',
    title: 'Quicklinks',
    cap: 5,

    search(query, ctx) {
        if (query === '') return [];

        // ctx.quicklinks is the Indicator's cache, refreshed on
        // changed::quicklinks. Falling back keeps the provider self-contained.
        const links = ctx.quicklinks ?? loadQuicklinks(ctx.settings);
        const results = [];

        // Keyword form: the first word selects the link, the rest is the query.
        const space = query.indexOf(' ');
        const head = (space < 0 ? query : query.slice(0, space)).toLowerCase();
        const tail = space < 0 ? '' : query.slice(space + 1).trim();

        const q = normalize(query);

        links.forEach((link, i) => {
            const keyword = (link.keyword ?? '').toLowerCase();
            if (keyword !== '' && keyword === head) {
                // An exact keyword hit is unambiguous — rank it above anything
                // matched by name.
                results.push(linkResult(link, tail, 2000, i));
                return;
            }
            const s = scoreAnyPre(q, [normalize(link.name), normalize(link.keyword ?? '')]);
            if (s !== NO_MATCH) results.push(linkResult(link, '', s, i));
        });

        // Fall back to a plain web search when nothing else caught the query.
        // Only for something that looks like a search rather than a stray
        // keystroke, and never when a quicklink already matched.
        if (results.length === 0 && query.length >= 3) {
            const template = ctx.settings?.get_string('search-url') || DEFAULT_SEARCH_URL;
            const url = buildUrl(template, query);
            results.push({
                id: 'quicklink:websearch',
                score: 1,
                index: 999,
                title: `Search the web for “${query}”`,
                subtitle: url,
                visual: { kind: 'icon', name: 'system-search-symbolic', size: 32 },
                accel: 'Open',
                run: () => { open(url); return { close: true }; },
            });
        }

        return results.sort(byScore);
    },
};
