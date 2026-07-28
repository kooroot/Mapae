import {createFileRoute} from "@tanstack/react-router";
import {Studio} from "../dapp/Studio";

export const Route = createFileRoute("/app")({
    component: Studio,
    head: () => ({
        meta: [
            {title: "Mapae Studio — Delegated payment control"},
            {
                name: "description",
                content:
                    "자산·금액·기간·수취인 경계를 지갑으로 승인하고, GIWA에서 에이전트 결제 권한과 정산 상태를 관리합니다.",
            },
        ],
    }),
});
