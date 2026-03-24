import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { KeysCard } from "./KeysCard";
import { DepositCard } from "./DepositCard";
import { ScanCard } from "./ScanCard";
import { TransferCard } from "./TransferCard";
import { WithdrawCard } from "./WithdrawCard";
import { DashboardCard } from "./DashboardCard";
import { HistoryCard } from "./HistoryCard";

export function TabNav() {
  return (
    <Tabs defaultValue="keys" className="w-full">
      <TabsList className="w-full mb-6 flex overflow-x-auto">
        <TabsTrigger value="keys" className="flex-1">
          Keys
        </TabsTrigger>
        <TabsTrigger value="deposit" className="flex-1">
          Deposit
        </TabsTrigger>
        <TabsTrigger value="scan" className="flex-1">
          Scan
        </TabsTrigger>
        <TabsTrigger value="transfer" className="flex-1">
          Transfer
        </TabsTrigger>
        <TabsTrigger value="withdraw" className="flex-1">
          Withdraw
        </TabsTrigger>
        <TabsTrigger value="dashboard" className="flex-1">
          Dashboard
        </TabsTrigger>
        <TabsTrigger value="history" className="flex-1">
          History
        </TabsTrigger>
      </TabsList>

      <TabsContent value="keys">
        <KeysCard />
      </TabsContent>

      <TabsContent value="deposit">
        <DepositCard />
      </TabsContent>

      <TabsContent value="scan">
        <ScanCard />
      </TabsContent>

      <TabsContent value="transfer">
        <TransferCard />
      </TabsContent>

      <TabsContent value="withdraw">
        <WithdrawCard />
      </TabsContent>

      <TabsContent value="dashboard">
        <DashboardCard />
      </TabsContent>

      <TabsContent value="history">
        <HistoryCard />
      </TabsContent>
    </Tabs>
  );
}
