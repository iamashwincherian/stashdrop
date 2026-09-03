import Canvas from "./Canvas";
import { getAllItemsWithMeta } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function Page() {
  const { items, bucket, recentOrder } = getAllItemsWithMeta();
  return <Canvas initialItems={items} initialBucket={bucket} initialRecentOrder={recentOrder} />;
}
