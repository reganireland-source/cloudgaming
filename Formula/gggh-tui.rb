class GgghTui < Formula
  desc "Terminal app for GGGH: monitor and control your cloud gaming machines"
  homepage "https://github.com/reganireland-source/cloudgaming/tree/main/tui"
  url "https://github.com/reganireland-source/cloudgaming/archive/df58c70ef04e20bd5fcfe8a637b646d437bc2565.tar.gz"
  version "0.5.2"
  sha256 "3cc7cddca6afa4f959d151cb6643fb10e0111ab5f59f3cf1831475028f3fb14d"
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
