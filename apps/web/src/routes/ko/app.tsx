import {createFileRoute} from "@tanstack/react-router";
import {Studio} from "../../dapp/Studio";
import {appHead} from "../app";

/** The Korean address for Studio. Same component and head as `/app` — see `ko/index.tsx`. */
export const Route = createFileRoute("/ko/app")({
    component: Studio,
    head: appHead,
});
