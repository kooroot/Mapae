import {createFileRoute} from "@tanstack/react-router";
import {RootSurface} from "@site-root";

// Let the router preload the page and its CSS before SSR and hydration.
export const Route = createFileRoute("/ko/")({component: RootSurface});
