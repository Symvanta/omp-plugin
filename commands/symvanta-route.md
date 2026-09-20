---
description: Resolve an HTTP route to the handler and middleware that serve it, from framework router metadata instead of a grep for the URL string.
argument-hint: "[route path] [method (optional)]"
---

Resolve this HTTP route to the code that serves it:

$ARGUMENTS

Steps:

1. Take the path from the argument above and call `find_http_route` with `path` set to it; a partial path matches, so the leading segment is enough when the full URL is unknown. Add `method` only when the argument names one, since a path served by several verbs otherwise returns every handler; when it does, keep the rows for the verb the user means and mention the others.
2. If no path was given, ask for the route path or the URL the user hit and stop. Do not guess a path, and do not substitute a local `grep` for the URL string: the graph resolves dynamic segments, prefix groups, and middleware-mounted routers that text search misses.
3. Pass `repository` (as `owner/name`) when the argument names one or the active project holds several. If the session is unbound, call `init` once with this checkout's GitHub remote first.
4. Report each match as `METHOD path -> filePath:startLine`, naming the handler and any middleware the router attaches on the way in. Do not open the file to rebuild a registration the router metadata already resolved; open it with `read` only to quote or edit the handler.
5. No match: say plainly that no indexed route matches, then retry with a broader partial path or a different spelling. If that stays empty, `locate` (mode:text) on a literal URL segment is the next step, and local search only after that. A route registered in code the index does not cover will not appear here.
6. Offer the follow-ups the route implies: `/symvanta-trace` on the handler, `/symvanta-blast` before changing it, or `list_tests_for` on the handler name.
