import { StaffReadOnly } from "@/app/maintenance/StaffReadOnly";
import { SafetyNotificationsBar } from "@/app/clinician/SafetyNotificationsBar";

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffReadOnly>
      <SafetyNotificationsBar />
      {children}
    </StaffReadOnly>
  );
}
