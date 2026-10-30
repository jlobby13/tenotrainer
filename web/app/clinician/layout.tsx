import { StaffReadOnly } from "@/app/maintenance/StaffReadOnly";
import { SafetyNotificationsBar } from "./SafetyNotificationsBar";

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffReadOnly>
      <SafetyNotificationsBar />
      {children}
    </StaffReadOnly>
  );
}
