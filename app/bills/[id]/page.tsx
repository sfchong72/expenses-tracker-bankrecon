"use client";

import { useParams } from "next/navigation";
import { Phase2Workspace } from "@/app/phase2-workspace";

export default function BillDetailPage() {
  const params = useParams<{ id: string }>();
  return <Phase2Workspace mode="bills" billId={params.id} />;
}
