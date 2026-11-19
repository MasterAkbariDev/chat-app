import { MembersPanel } from "@/components/chat/MembersPanel";

export default async function ChatMembersPage(props: PageProps<"/app/c/[channelId]/members">) {
  const { channelId } = await props.params;
  return <MembersPanel channelId={channelId} />;
}
