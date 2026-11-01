class GgghTui < Formula
  desc "Terminal app for GGGH: monitor and control your cloud gaming machines"
  homepage "https://github.com/reganireland-source/cloudgaming/tree/main/tui"
  url "https://github.com/reganireland-source/cloudgaming/archive/370f740278498a2e79e5279d173f416847c07555.tar.gz"
  version "0.2.0"
  sha256 "f6f85b3a05f087ba545c9cd6d6620de4c8e1f2a010c0a6b0a8c941eb4c12a748"
  head "https://github.com/reganireland-source/cloudgaming.git", branch: "main"

  depends_on "go" => :build

  def install
    cd "tui" do
      system "go", "build", *std_go_args(ldflags: "-s -w -X main.version=#{version}")
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/gggh-tui --version")
  end
end
