import { ChatPermissionsPanel } from "./ChatPermissionsPanel";

export default async function ChatPermissionsPage(props: PageProps<"/app/c/[channelId]/permissions">) {
  const { channelId } = await props.params;
  return <ChatPermissionsPanel channelId={channelId} />;
}
