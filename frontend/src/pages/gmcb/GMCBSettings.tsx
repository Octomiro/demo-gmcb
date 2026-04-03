import { Card } from "@/components/ui/card";
import { Settings } from "lucide-react";

const GMCBSettings = () => (
  <div className="p-6 space-y-6">
    <div className="flex items-center gap-4">
      <div className="p-3 rounded-xl bg-primary">
        <Settings className="w-6 h-6 text-primary-foreground" />
      </div>
      <div>
        <h1 className="text-2xl font-bold text-foreground">Paramètres</h1>
        <p className="text-muted-foreground">Configuration du module GMCB</p>
      </div>
    </div>
    <Card className="p-6">
      <p className="text-muted-foreground text-center py-12">Les paramètres seront disponibles prochainement.</p>
    </Card>
  </div>
);

export default GMCBSettings;
