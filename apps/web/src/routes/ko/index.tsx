import {createFileRoute} from "@tanstack/react-router";
import {RootSurface, rootSurfaceHead} from "../index";

/*
 * The Korean address for the root surface.
 *
 * It renders the same component and the same `head()` as `/`, because none of that
 * differs by language — the strings inside already read the locale, and the locale is
 * now resolved from this very path. Duplicating the component here would fork every
 * future landing change into two files that must stay identical.
 */
export const Route = createFileRoute("/ko/")({
    component: RootSurface,
    head: rootSurfaceHead,
});
