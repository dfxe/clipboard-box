// The command bar's plumbing. Every source of results — clipboard history,
// screenshots, and the Raycast-style tools — is a provider with the same shape,
// so ranking, capping and the empty-state rules are written once instead of once
// per source.
//
// Providers are pure and synchronous: search() looks at a query and returns
// descriptors, nothing more. Anything slow or asynchronous (reading image bytes,
// fetching exchange rates) belongs in run(), which fires on activation.
//
//   Provider = {
//     id,                        // stable, used for CSS hooks and debugging
//     title,                     // section header text
//     cap,                       // max results contributed to one refresh
//     search(query, ctx),        // -> Result[]  (already sorted, best first)
//     emptyMessage(ctx),         // optional; only shown when the query is empty
//   }
//
//   Result = {
//     id,                        // unique within a refresh; keeps selection stable
//     title,                     // main line, ellipsized
//     subtitle,                  // dim second line
//     visual,                    // see below — plain data, no actors
//     accel,                     // optional right-aligned hint, e.g. 'Enter'
//     actions,                   // optional [{ icon, styleClass, tooltip, run(ctx) }]
//     accessibleText,            // optional full text for screen readers
//     run(ctx),                  // -> { message, close } | null
//   }
//
//   Result.visual is data so providers never import St:
//     { kind: 'gicon',  path, size }     file thumbnail
//     { kind: 'icon',   name, size }     symbolic icon
//     { kind: 'swatch', color }          solid colour chip
//     { kind: 'glyph',  text }           literal character (emoji, symbols)
//
// run() and action.run() may call ctx.requestPaste() at the moment the clipboard
// actually holds the new content — the Indicator defers the keystroke until the
// popup has closed. Returning { message } plays the row flash; { close: true }
// closes the popup afterwards.

// A non-empty query hides empty sections entirely rather than stacking six
// "No matches" rows. When nothing at all matched, the caller shows one global
// empty row instead.
export function runSearch(providers, query, ctx) {
    const groups = [];
    const browsing = query === '';

    for (const provider of providers) {
        let results;
        try {
            results = provider.search(query, ctx) ?? [];
        } catch (e) {
            // One misbehaving provider must not take the whole popup down.
            logError(e, `clipboard-box: provider "${provider.id}" failed`);
            results = [];
        }

        if (results.length > 0) {
            groups.push({ provider, results: results.slice(0, provider.cap) });
            continue;
        }

        // Empty: only worth a header plus a hint while browsing, and only if the
        // provider has something to say (the tools stay silent).
        if (!browsing) continue;
        let message;
        try {
            message = provider.emptyMessage?.(ctx);
        } catch (e) {
            // Inside the boundary for the same reason search() is: a throw here
            // would otherwise escape into the caller's rebuild loop and leave
            // the list half-built.
            logError(e, `clipboard-box: provider "${provider.id}" emptyMessage failed`);
            continue;
        }
        if (message) groups.push({ provider, results: [], emptyMessage: message });
    }

    return groups;
}

export function totalResults(groups) {
    return groups.reduce((n, g) => n + g.results.length, 0);
}
