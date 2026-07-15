import { ClaimsWorkspace } from "@/app/claims/claims-workspace";

export default async function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ClaimsWorkspace mode="all" claimId={id} />;
}
