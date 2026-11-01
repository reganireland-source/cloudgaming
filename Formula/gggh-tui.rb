class GgghTui < Formula
  desc "Terminal app for GGGH: monitor and control your cloud gaming machines"
  homepage "https://github.com/reganireland-source/cloudgaming/tree/main/tui"
  url "https://github.com/reganireland-source/cloudgaming/archive/9f509474007c3ec57d0fe8735b68b4eb2aebcd2d.tar.gz"
  version "0.4.0"
  sha256 "60bc8f6042ed2fbb8d66d4027a4f7fcf662f93795385de2295f85e684958a4e0"
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
