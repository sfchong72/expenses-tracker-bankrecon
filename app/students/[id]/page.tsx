import { StudentOperationsWorkspace } from "@/app/student-operations-workspace";

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentOperationsWorkspace mode="student-detail" id={id} />;
}
