import {createFileRoute} from "@tanstack/react-router";
import {Arcade} from "../../arcade/Arcade";

export const Route = createFileRoute("/ko/arcade")({component: Arcade});
