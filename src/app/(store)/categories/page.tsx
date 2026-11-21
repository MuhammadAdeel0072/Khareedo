// All categories index page.
import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { getCategoryTree, type CategoryNode } from "@/services/categories.service";

export const metadata: Metadata = { title: "All Categories" };
export const dynamic = "force-dynamic";

/** Renders a category's children recursively, so grandchildren (and deeper)
 *  nest under their parent instead of being dropped. */
function CategoryChildren({ nodes }: { nodes: CategoryNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="mt-4 grid grid-cols-2 gap-2">
      {nodes.map((child) => (
        <li key={child.id}>
          <Link
            href={`/products?category=${child.slug}`}
            className="flex items-center gap-2.5 rounded-lg border p-2.5 text-sm transition hover:border-primary/30 hover:bg-brand-50"
          >
            <span className="relative h-9 w-9 overflow-hidden rounded-md bg-muted">
              <Image src={child.imageUrl ?? "/images/placeholder.svg"} alt="" fill sizes="36px" className="object-cover" />
            </span>
            <span className="min-w-0 truncate font-medium">{child.name}</span>
          </Link>
          {child.children.length > 0 && (
            <div className="ml-5 mt-2 border-l pl-3">
              <CategoryChildren nodes={child.children} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function CategoriesPage() {
  const tree = await getCategoryTree();

  return (
    <div className="container-khd py-8">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">All Categories</h1>
      <p className="mb-8 mt-1 text-sm text-muted-foreground">Explore everything Khareedo has to offer</p>

      {/* Empty state (Phase 3, chunk 12 follow-up B): the header used to
          render over an empty grid. */}
      {tree.length === 0 ? (
        <p className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          No categories yet — check back soon.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {tree.map((cat) => (
            <section key={cat.id} className="rounded-xl border p-5">
              <Link href={`/products?category=${cat.slug}`} className="group flex items-center gap-3">
                <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                  <Image src={cat.imageUrl ?? "/images/placeholder.svg"} alt="" fill sizes="48px" className="object-cover" />
                </span>
                <h2 className="min-w-0 flex-1 truncate text-lg font-bold group-hover:text-primary">{cat.name}</h2>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" aria-hidden="true" />
              </Link>
              {cat.description && <p className="mt-1 text-xs text-muted-foreground">{cat.description}</p>}
              <CategoryChildren nodes={cat.children} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
