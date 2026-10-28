import { createFileRoute, redirect } from "@tanstack/react-router";

// This instance is a personal collection app, not the upstream marketing site.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/rifter" });
  },
});
