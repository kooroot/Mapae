import {createFileRoute, notFound} from "@tanstack/react-router";
import {Arcade} from "../../../arcade/Arcade";
import {isArcadeSubsection} from "../../../arcade/sections";

/** The Korean address of the arcade sections; see `routes/arcade/{-$section}.tsx`. */
export const Route = createFileRoute("/ko/arcade/{-$section}")({
    beforeLoad: ({params}) => {if (params.section !== undefined && !isArcadeSubsection(params.section)) throw notFound();},
    component: Arcade,
});
