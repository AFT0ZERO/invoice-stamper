<script lang="ts">
  import Upload from "./pages/Upload.svelte";
  import Review from "./pages/Review.svelte";
  import type { Row } from "./lib/types";

  let rows = $state<Row[] | null>(null);
</script>

<header>
  <a
    href="/"
    onclick={(e) => {
      e.preventDefault();
      rows = null;
    }}>ختم فواتير ACT — اسم التاجر ورقم المرجع</a
  >
</header>
<main>
  {#if rows}
    <Review {rows} onback={() => (rows = null)} />
  {:else}
    <Upload onanalyzed={(r) => (rows = r)} />
  {/if}
</main>
