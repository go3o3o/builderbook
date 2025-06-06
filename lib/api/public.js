import sendRequest from "./sendRequest";

const BASE_PATH = "/api/v1/public";

export const getBookList = () =>
  sendRequest(`${BASE_PATH}/books`, {
    method: "GET",
  });

export const getBookDetail = ({ slug }) =>
  sendRequest(`${BASE_PATH}/books/${slug}`, {
    method: "GET",
  });

export const getChapterDetail = ({ bookSlug, chapterSlug }, options = {}) =>
  sendRequest(
    `${BASE_PATH}/get-chapter-detail?bookSlug=${bookSlug}&chapterSlug=${chapterSlug}`,
    Object.assign(
      {
        method: "GET",
      },
      options
    )
  );

export const getTOS = () =>
  sendRequest(`${BASE_PATH}/get-tos`, {
    method: "GET",
  });

export const getTableOfContents = ({ slug }) =>
  sendRequest(`${BASE_PATH}/get-table-of-contents?slug=${slug}`, {
    method: "GET",
  });
