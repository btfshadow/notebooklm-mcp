/**
 * Complete each blog post's structured data.
 *
 * Docusaurus already emits a BlogPosting per post, with the headline, the
 * description, the date and the author — all correct. What it cannot know is
 * who publishes the site and what the posts are about, which is exactly what
 * an engine uses to attribute them.
 *
 * So this adds a fragment carrying the same `@id` rather than a second
 * BlogPosting. JSON-LD merges nodes by identifier, and two competing articles
 * on one page is a worse signal than none.
 */

import React, { type ReactNode } from 'react';
import Head from '@docusaurus/Head';
import BlogPostItem from '@theme-original/BlogPostItem';
import type BlogPostItemType from '@theme/BlogPostItem';
import type { WrapperProps } from '@docusaurus/types';
import { useBlogPost } from '@docusaurus/plugin-content-blog/client';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

type Props = WrapperProps<typeof BlogPostItemType>;

const ORGANIZATION_ID = 'https://roomi-fields.com/#organization';
const WEBSITE_ID = 'https://notebooklm.roomi-fields.com/#website';
const SOFTWARE_ID = 'https://notebooklm.roomi-fields.com/#software';

/**
 * Escape the characters that make a JSON payload ambiguous inside HTML. They
 * remain valid JSON as unicode escapes.
 */
function serialize(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export default function BlogPostItemWrapper(props: Props): ReactNode {
  const { metadata, isBlogPostPage } = useBlogPost();
  const {
    siteConfig: { url: siteUrl },
  } = useDocusaurusContext();

  // The listing renders every post through this component too; only the post's
  // own page should claim to be the article.
  if (!isBlogPostPage) return <BlogPostItem {...props} />;

  const schema = {
    '@context': 'https://schema.org',
    '@id': `${siteUrl}${metadata.permalink}`,
    publisher: { '@id': ORGANIZATION_ID },
    isPartOf: { '@id': WEBSITE_ID },
    about: { '@id': SOFTWARE_ID },
  };

  return (
    <>
      <Head>
        <script type="application/ld+json">{serialize(schema)}</script>
      </Head>
      <BlogPostItem {...props} />
    </>
  );
}
