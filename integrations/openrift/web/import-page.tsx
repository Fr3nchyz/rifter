import { Navigate } from "@tanstack/react-router";

// Native import entry points use the same authenticated quarantine workspace.
export function CollectionImportPage() {
  return <Navigate to="/rifter" hash="imports" />;
}
export const DeckImportPage = CollectionImportPage;
