import { AddPackView } from "./AddPackView";

export default async function AddPackPage(props: PageProps<"/app/addpack/[slug]">) {
  const { slug } = await props.params;
  return <AddPackView slug={slug} />;
}
