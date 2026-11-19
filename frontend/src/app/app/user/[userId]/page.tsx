import { UserProfilePanel } from "@/components/chat/UserProfilePanel";

export default async function UserProfilePage(props: PageProps<"/app/user/[userId]">) {
  const { userId } = await props.params;
  return <UserProfilePanel userId={userId} />;
}
