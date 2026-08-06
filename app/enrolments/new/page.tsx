import { StudentOperationsWorkspace } from "@/app/student-operations-workspace";

export default async function NewEnrolmentPage({ searchParams }: { searchParams: Promise<{ student_id?: string; enrolment_id?: string }> }) {
  const { student_id, enrolment_id } = await searchParams;
  return <StudentOperationsWorkspace mode="enrolment-form" initialStudentId={student_id} initialEnrolmentId={enrolment_id} />;
}
