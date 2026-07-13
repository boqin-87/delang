import { Streamup } from "@opticlm/streamup";
import type { DelangResult } from "../../worker/index";

export function ResultView({ data }: { data: DelangResult }) {
  return (
    <div className="typeset typeset-docs max-w-2xl mx-auto my-8">
      <Streamup>{data.markdown}</Streamup>
      <hr />
      <footer>
        <a href={data.url}>{data.meta.domain || data.url}</a>
        {data.meta.author ? ` · ${data.meta.author}` : null}
        {data.meta.published ? ` · ${data.meta.published}` : null}
      </footer>
    </div>
  );
}
