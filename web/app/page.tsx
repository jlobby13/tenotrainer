import { redirect } from "next/navigation";

// Root redirects to dashboard; middleware will redirect to /login if unauthenticated.
export default function RootPage() {
  redirect("/dashboard");
}
