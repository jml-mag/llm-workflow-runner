// amplify/functions/workflow-runner/src/prompt/formatters/index.ts
import { BaseMessage, SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import type { PromptSegment } from "../types";

/**
* Convert prompt segments to LangChain BaseMessage array
* LangChain handles provider normalization automatically
*/
export function formatMessages(segments: PromptSegment[]): BaseMessage[] {
 return segments.map(segment => {
   switch (segment.role) {
     case "system":
       return new SystemMessage(segment.content);
     case "user":
       return new HumanMessage(segment.content);
     case "assistant":
       return new AIMessage(segment.content);
     default:
       throw new Error(`Unknown role: ${segment.role}`);
   }
 });
}