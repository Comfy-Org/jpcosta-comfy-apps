import type { Metadata } from "next";
import { UnrenderApp } from "@/components/unrender/unrender-app";
import "./unrender.css";

export const metadata: Metadata = {
  title: "Unrender",
  description: "Turn any final shot back into a grey blocking playblast.",
};

export default function UnrenderPage() {
  return <UnrenderApp />;
}
