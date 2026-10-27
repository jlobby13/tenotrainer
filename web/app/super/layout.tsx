import { StaffReadOnly } from "@/app/maintenance/StaffReadOnly";

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return <StaffReadOnly>{children}</StaffReadOnly>;
}
