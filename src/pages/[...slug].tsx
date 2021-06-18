import React from 'react';
import { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from 'next';
import NextHead from 'next/head';
import NextRouter, { useRouter } from 'next/router';
import NProgress from 'nprogress';

import { Hydrate } from '../mdx';

import { ThemeStyles } from '../components/ThemeStyles';
import { Layout } from '../components/Layout';
import { Error, ErrorBoundary } from '../templates/error';

import { ConfigContext } from '../utils/config';
import { IRenderError, redirect, RenderError } from '../utils/error';
import { SlugProperties, SlugPropertiesContext, Properties } from '../utils/properties';
import { PageContentContext, getPageContent, PageContent, HeadingNode } from '../utils/content';
import { getPullRequestMetadata, getRepositoriesPaths, getRepositoryList } from '../utils/github';
import { CustomDomain, CustomDomainContext, getCustomDomain } from '../utils/domain';
import { getHeadTags } from '../utils/html';
import { isProduction, routeChangeComplete, routeChangeError, routeChangeStart } from '../utils';
import { mdxSerialize } from '../utils/mdx-serialize';
import { Loading } from '../templates/Loading';
import { getDomainsList } from '../utils/file';

NProgress.configure({ showSpinner: false });
NextRouter.events.on('routeChangeStart', routeChangeStart);
NextRouter.events.on('routeChangeComplete', routeChangeComplete);
NextRouter.events.on('routeChangeError', routeChangeError);

export default function Documentation({
  domain,
  source,
  properties,
  content,
  error,
}: InferGetStaticPropsType<typeof getStaticProps>) {
  const { isFallback } = useRouter();

  if (isFallback) {
    return <Loading />;
  }

  if (error) {
    return <Error {...error} />;
  }

  const tags = getHeadTags(properties, content);

  return (
    <>
      <NextHead>{tags}</NextHead>
      <CustomDomainContext.Provider value={domain}>
        <ConfigContext.Provider value={content.config}>
          <SlugPropertiesContext.Provider value={properties}>
            <PageContentContext.Provider value={content}>
              <ThemeStyles />
              <Layout>
                <ErrorBoundary>
                  <Hydrate source={source} />
                </ErrorBoundary>
              </Layout>
            </PageContentContext.Provider>
          </SlugPropertiesContext.Provider>
        </ConfigContext.Provider>
      </CustomDomainContext.Provider>
    </>
  );
}

export const getStaticPaths: GetStaticPaths = async () => {
  let paths = [];

  // Since this call can be fairly large, only run it on production
  // and let the development pages fallback each time.
  if (isProduction()) {
    const repositories = await getRepositoryList();
    paths = await getRepositoriesPaths(repositories);
    console.info(`- gathered ${paths.length} static pages.`);
  }

  return {
    paths,
    fallback: true,
  };
};

type StaticProps = {
  domain: CustomDomain;
  properties: SlugProperties;
  headings: HeadingNode[];
  source?: string;
  content?: PageContent;
  error?: IRenderError;
};

export const getStaticProps: GetStaticProps<StaticProps> = async ctx => {
  let slug = ctx.params.slug as string[];
  let source = null;
  let headings: HeadingNode[] = [];
  let error: RenderError = null;
  let content: PageContent;

  /**
   * When a custom domain points to the root, the `beforeFiles` rewrite (next.config.js) is triggered:
   *   -> destination: `/${organization}/${repo}`,
   * This incoming request is also then picked up by the `afterFiles` rewrite, and appends the org & repo
   * to the destination too:
   *   -> destination: `/${organization}/${repo}/:path*`,
   *
   * In this scenario, the slug comes through as `[':org', ':repo', ':org', ':repo']`,  so we
   * rewrite the slug if we think this scenario has happened.
   */
  if (slug.length === 4) {
    if (slug[0] === slug[2] && slug[1] === slug[3]) {
      slug = [slug[0], slug[1]];
    }
  }

  // Extract the slug properties from the request.
  const properties = new Properties(slug);

  // If the ref looks like a PR, update the details to point towards
  // the PR owner (which might be a different repo)
  if (properties.isPullRequest()) {
    const metadata = await getPullRequestMetadata(
      properties.owner,
      properties.repository,
      parseInt(properties.ref),
    );

    // If a PR was found, update the property metadata
    if (metadata) {
      properties.setPullRequestMetadata(metadata);
    }
  }

  content = await getPageContent(properties);

  if (!content) {
    // If there is no content, the repository is not found
    error = RenderError.repositoryNotFound(properties);
  } else if (content.frontmatter.redirect) {
    // Redirect the user to another page
    return redirect(content.frontmatter.redirect, properties);
  } else {
    // At this point there is a repository, however there still might not be a file for the path

    // If no property ref has been set, assign the base branch (usually main or master)
    if (!properties.ref) {
      properties.setBaseRef(content.baseBranch);
    }

    if (content.markdown) {
      const serialization = await mdxSerialize(content);

      if (serialization.error) {
        error = RenderError.serverError(properties);
      } else {
        source = serialization.source;
        content.headings = serialization.headings as HeadingNode[];
      }
    } else {
      error = RenderError.pageNotFound(properties);
    }
  }

  return {
    props: {
      domain: getCustomDomain(getDomainsList(), properties),
      properties: properties.toObject(),
      source,
      headings,
      content,
      error: error?.toObject() ?? null,
    },
    revalidate: 30,
  };
};
