import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_app/_authenticated/rifter")({
  ssr: false,
  staticData: { hideFooter: true },
});
