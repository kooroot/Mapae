import {createFileRoute, notFound} from "@tanstack/react-router";
import {Arcade} from "../../arcade/Arcade";
import {isArcadeSubsection} from "../../arcade/sections";

// One route for every arcade section: only the param changes between them, so the shell (and its single guardian desk) stays mounted.
export const Route = createFileRoute("/arcade/{-$section}")({
    beforeLoad: ({params}) => {if (params.section !== undefined && !isArcadeSubsection(params.section)) throw notFound();},
    component: Arcade,
});
