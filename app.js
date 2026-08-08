const POSTS = [
  {
    title: "欢迎来到我的博客",
    date: "2026-05-30",
    file: "posts/welcome.md"
  }
];

function renderPosts() {
  const list = document.getElementById("post-list");
  if (!list) return;

  const items = POSTS.map(function (post) {
    return (
      '<a class="post-item" href="' + post.file + '">' +
        '<div class="title">' + post.title + '</div>' +
        '<div class="date">' + post.date + '</div>' +
      '</a>'
    );
  });

  list.innerHTML = items.join("");
}

renderPosts();
