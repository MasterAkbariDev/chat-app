import { ChatInfoPanel } from "@/components/chat/ChatInfoPanel";

export default async function ChatInfoPage(props: PageProps<"/app/c/[channelId]/info">) {
  const { channelId } = await props.params;
  return <ChatInfoPanel channelId={channelId} />;
}
