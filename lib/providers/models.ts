/**
 * Display names for the model IDs a ledger entry or a recording carries, so
 * the page can say which model really answered. No SDK here: client
 * components import it. An ID without a name shows as itself, without its
 * owner prefix.
 */
const LABELS: Readonly<Record<string, string>> = {
  "nvidia/Nemotron-3.5-Super-VL": "Nemotron 3.5 Super VL",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": "Nemotron 3 Nano",
  "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super",
  "nvidia/Nemotron-3-Ultra-550b-a55b": "Nemotron 3 Ultra",
  "nvidia/Nemotron-3_5-Lightning": "Nemotron 3.5 Lightning",
};

export function modelLabel(id: string): string {
  return LABELS[id] ?? id.slice(id.indexOf("/") + 1);
}
