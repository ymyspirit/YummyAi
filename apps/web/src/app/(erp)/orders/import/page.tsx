import { redirect } from "next/navigation";

export default function AmazonReportImportPage() {
  redirect("/orders?view=reports");
}
