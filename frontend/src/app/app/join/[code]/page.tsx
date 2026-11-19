import { JoinChatView } from "./JoinChatView";

export default async function JoinChatPage(props: PageProps<"/app/join/[code]">) {
  const { code } = await props.params;
  return <JoinChatView code={code} />;
}
