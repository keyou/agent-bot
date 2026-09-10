export type Command =
  | { type: "shell"; command: string }
  | { type: "new"; title?: string; cwd?: string; projectless?: boolean }
  | {
      type: "newgroup";
      title?: string;
      cwd?: string;
      projectless?: boolean;
      sessionId?: string;
      agentName?: string;
    }
  | { type: "dir"; directory?: string }
  | { type: "file"; filePath: string }
  | { type: "forkgroup"; title?: string }
  | { type: "fork"; sessionId?: string }
  | { type: "title"; title: string }
  | { type: "nosteer"; text: string }
  | { type: "sessions"; searchTerm?: string }
  | { type: "switch"; sessionId?: string }
  | { type: "agent"; agent?: string }
  | { type: "archive"; sessionId?: string }
  | { type: "dismiss" }
  | { type: "stop" }
  | { type: "status"; sessionId?: string }
  | { type: "goal"; action: "show" }
  | { type: "goal"; action: "set" | "edit"; objective: string }
  | { type: "goal"; action: "pause" | "resume" | "clear" }
  | { type: "restart"; force?: boolean }
  | { type: "release" }
  | { type: "mute"; enabled: boolean }
  | { type: "turns" }
  | { type: "model" }
  | { type: "provider" }
  | { type: "thinking" }
  | { type: "permissions" }
  | { type: "help" }
  | { type: "prompt"; text: string };
