"use client";

import { PRINCIPAL } from "@/lib/config";
import { PozoApp } from "@/components/PozoApp";

export default function Home() {
  return <PozoApp pozo={PRINCIPAL} activo="app" />;
}
