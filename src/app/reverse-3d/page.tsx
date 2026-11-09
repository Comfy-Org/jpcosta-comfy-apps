import { redirect } from "next/navigation";

/** The app's old name. Links to it land on Unrender. */
export default function Reverse3dPage() {
  redirect("/unrender");
}
